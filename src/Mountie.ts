import { AbortController } from "node-abort-controller";
import { EventEmitter } from "events";
import Path from "path";
import SystemInformation from "systeminformation";
import * as UUID from "uuid";

import { EventIterable } from "event-iterable";

import { FolderDeletionWatcher } from "./FolderDeletionWatcher";
import { isDirectory, sleep } from "./Functions";

/** @module MountMonitor */

const UUID_NAMESPACE = "6ba7b815-9dad-11d1-80b4-00c04fd430c8"; // Next above RFC defined namepsaces
const INTERVAL_LENGTH = 10000;

const SORT = true;

const IGNORED_MOUNT_POINTS_REGEX:{"darwin":RegExp[], "linux":RegExp[], "win32":RegExp[] } = {
    "darwin": [
            /^$/,
            /^\/private\//,
            /^\/Volumes\/Recovery$/,
            /^\/System\//
        ],
    "linux": [],
    "win32": [],
};


export type FileSystem = {
    device: string,
    label: string,
    filesystem: string,
    model?: string|undefined,
    mountpoint?: string|undefined,
    mounted: boolean,
    protocol: string,
    serial?: string|undefined,
    size: {
        available: number,
        total: number,
        used: number,
    },
    uuid: string,
}

export type FileSystemMountEvent = { filesystem: FileSystem, type:"mount" };
export type FileSystemRenameEvent = { filesystem: FileSystem, oldFilesystem:FileSystem, type:"rename" };
export type FileSystemUnmountEvent = { filesystem: FileSystem, type:"unmount" };


export type FileSystemEvent = FileSystemMountEvent|FileSystemRenameEvent|FileSystemUnmountEvent;

let deletionWatchers: {[path:string]:FolderDeletionWatcher} = {};

export class Mountie extends EventEmitter implements AsyncIterable<FileSystemEvent>, Iterable<FileSystem> {


    #abortController:AbortController|undefined;
    #mountedMap:{[key:string]:FileSystem} = {};

    public constructor() {
        super();
        this.#onMount.bind(this);
        this.#onRename.bind(this);
        this.#onUnmount.bind(this);
    }

    get mounted():readonly FileSystem[] {return sortFilesystems( Object.values( this.#mountedMap ) ); };
    get running():boolean { return !!this.#abortController; }


    *[Symbol.iterator]():Iterator<FileSystem, any, undefined> {
        for( const filesystem of this.mounted ) {
            yield filesystem;
        }
    }

    async* [Symbol.asyncIterator](): AsyncIterator<FileSystemEvent, any, undefined> {
        if( !this.running ) {
            await this.start();
        }

        for( const filesystem of this ) {
            yield { filesystem, type: "mount" };
        }

        const ei = new EventIterable( this, "all" );
        for await ( const event of ei ) {
            yield event.value;
        }
        
    }


    async #monitor():Promise<void>
    {
        while( this.running ) {
            const startTime = new Date();
            const newState = await getNewState();
            if( this.running ) {
                const events:FileSystemEvent[] = [];
                const uuidFilesystemMap:{[uuid:string]:FileSystem} = newState.reduce( ( R, fs ) => ( { ...R, [ fs.uuid ]: fs } ) , {} );
            
                await Promise.all(
                    newState.map( async ( filesystem:FileSystem )=> {
                        const path = filesystem.mountpoint!;
                        const oldFilesystem = this.#mountedMap[ path ];
                        if( await isDirectory( path ) && oldFilesystem===undefined ) {
                            events.push( { filesystem, type: "mount" } );
                        }
                    } )
                );
            
                // for( const oldFilesystem of this.state ) {
                for( const oldFilesystem of this.mounted ) {
                    const filesystem = uuidFilesystemMap[ oldFilesystem.uuid ];
                    if( filesystem===undefined ) {
                        events.push( { filesystem:oldFilesystem, type: "unmount" } );
                    } else if(filesystem.label!==oldFilesystem.label) {
                        events.push( { filesystem, oldFilesystem, type: "rename" } );
                    }
                }
            
                events.forEach( ( event ) => {
                    this.emit( event.type, event );
                    this.emit( "all", event );
                } );
                this.emit( "changed" );
                this.emit( "refresh" );
            }

            const endTime = new Date();

            if( this.running ) {
                const sleepDuration = Math.max( INTERVAL_LENGTH/2, INTERVAL_LENGTH-(endTime.getTime()-startTime.getTime()) );
                await sleep( INTERVAL_LENGTH, this.#abortController!.signal );
            }
        }
    }

    #onMount( event:FileSystemMountEvent ):void {
        const path = event.filesystem.mountpoint!;
        this.#mountedMap[ path ] = event.filesystem;
        deletionWatchers[ path ] = new FolderDeletionWatcher( path, () => {
            const filesystem = this.#mountedMap[ path ];
            if( filesystem ) {
                const event: FileSystemUnmountEvent = { filesystem, type:"unmount" };
                this.emit( "unmount",  event );
                this.emit( "all", event );
                this.emit( "changed" );
            }
        } );
    }

    #onRename( event:FileSystemRenameEvent ):void {
        if( event.oldFilesystem.mounted ) {
            this.#onUnmount( { filesystem:event.oldFilesystem, type:"unmount" } );
        }
        if( event.filesystem.mounted ) {
            this.#onMount( { filesystem:event.filesystem, type:"mount" } );
        }
    }

    #onUnmount( event:FileSystemUnmountEvent ):void {
        const path = event.filesystem.mountpoint!;
        delete this.#mountedMap[ path ];
        deletionWatchers[ path ].stop();
        delete deletionWatchers[ path ];
    }

    public filesystem( path:string ):FileSystem|undefined {
        return Object.entries( this.#mountedMap )
            .reduce<FileSystem|undefined>( (R, [ mountPath, filesystem ] ) => {
                if( ( !R || mountPath.length>R!.mountpoint!.length ) && path.startsWith( mountPath ) ) {
                    return filesystem;
                }
                return R;
            }, undefined );
    }

    public isMounted( path:string ):boolean {
        return this.mounted.some( drive => drive.mountpoint===path );
    }

    public async nextRefresh():Promise<void> {
        if( this.running ) {
            return new Promise( resolve => this.once( "refresh", resolve ) );
        } else {
            throw new Error( "Mountie is not running" );
        }
    }

    public async start():Promise<void> {
        if( this.running===false )
        {
            this.#abortController = new AbortController();
            this.on( "mount", this.#onMount );
            this.on( "rename", this.#onRename );
            this.on( "unmount", this.#onUnmount );
            this.#mountedMap = {};
            this.#monitor();
            return this.nextRefresh();
        }
    }

    public stop():void {
        if( this.running ) {
            this.#abortController?.abort();
            this.#abortController = undefined;;
            this.removeListener( "mount", this.#onMount );
            this.removeListener( "rename", this.#onRename );
            this.removeListener( "unmount", this.#onUnmount );
        }
    }

    public async waitForSetup():Promise<void> {
        while( this.mounted.length===0 ) {
            await this.nextRefresh();
        }
    }

}



async function getNewState():Promise<FileSystem[]> {
    const [ devices, filesystems ] = await Promise.all( [
            SystemInformation.blockDevices(),
            SystemInformation.fsSize(),
        ] );

    return sortFilesystems( createMountedFileSystemsList( filesystems, devices ) );

}

function createMountedFileSystemsList( filesystems: SystemInformation.Systeminformation.FsSizeData[], devices: SystemInformation.Systeminformation.BlockDevicesData[] ): FileSystem[] {

    const deviceMap:{[device:string]:SystemInformation.Systeminformation.BlockDevicesData} = devices.reduce( (R, dev) => ( {...R, [dev.name]:dev } ), {} );
    const filteredFileSystems = filesystems
        .filter( (fs) => IGNORED_MOUNT_POINTS_REGEX[ process.platform as "darwin"|"linux"|"win32" ].every( regEx => regEx.test(fs.mount)===false ) )
        .filter( (fs) => String(fs.size)!=='' )
        .filter( (fs) => deviceMap[fs.fs]===undefined || deviceMap[fs.fs].protocol!=="Disk Image" )
    ;

    if( process.platform ==="win32" ) {
        return filteredFileSystems.map<FileSystem>( ( filesystem ) => ( {
            device: filesystem.fs,
            label: deviceMap[filesystem.fs].label!=="" ? deviceMap[filesystem.fs].label : filesystem.fs.split(Path.sep).pop()!,
            filesystem: deviceMap[filesystem.fs].physical!=="Network" ? filesystem.type : "SMB",
            model: undefined,
            mountpoint: filesystem.mount,
            mounted: true,
            protocol: deviceMap[filesystem.fs].physical!=="Network" ? deviceMap[filesystem.fs].physical : "SMB",
            serial: deviceMap[filesystem.fs].serial!=="" ? deviceMap[filesystem.fs].serial : undefined,
            size: {
                available: filesystem.available,
                total: filesystem.size,
                used: filesystem.used,
            },
            uuid: deviceMap[filesystem.fs].uuid!=="" ? deviceMap[filesystem.fs].uuid.toLowerCase() : UUID.v5( filesystem.fs, UUID_NAMESPACE ),
        } ) );
    } else {
        return filteredFileSystems.map<FileSystem>( ( filesystem ) => ( {
            device: filesystem.fs,
            label: deviceMap[filesystem.fs] ? deviceMap[filesystem.fs].label : filesystem.fs.split(Path.sep).pop()!,
            filesystem: deviceMap[filesystem.fs] ? filesystem.type : "SMB",
            model: undefined,
            mountpoint: filesystem.mount,
            mounted: true,
            protocol: deviceMap[filesystem.fs] ? deviceMap[filesystem.fs].protocol : "SMB",
            serial: deviceMap[filesystem.fs] && deviceMap[filesystem.fs].serial!=="" ? deviceMap[filesystem.fs].serial : undefined,
            size: {
                available: filesystem.available,
                total: filesystem.size,
                used: filesystem.used,
            },
            uuid: deviceMap[filesystem.fs] ? deviceMap[filesystem.fs].uuid.toLowerCase() : UUID.v5( filesystem.fs, UUID_NAMESPACE ),
        } ) );
    }

}

function sortFilesystems( filesystems:FileSystem[] ):FileSystem[] {
    if(!SORT) return filesystems;
    switch(process.platform)
    {
        case "darwin":
            return filesystems.sort( ( a, b ) => {
                const aLabel = a.label===""?"Untitled":a.label;
                const bLabel = b.label===""?"Untitled":b.label;
                return aLabel.toUpperCase().localeCompare(bLabel.toUpperCase())
            } );

        case "linux":
        case "win32":
        default:
            return filesystems.sort( ( a, b ) => {
                const aStr = a.mounted ? a.mountpoint! : a.device;
                const bStr = b.mounted ? b.mountpoint! : b.device;
                return aStr.toUpperCase().localeCompare(bStr.toUpperCase())
            } );
    }

}